import { describe, expect, test } from "bun:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { AnthropicAgent, OpenAIAgent } from "../src/index.js";
import { z } from "zod";
function createFakeModel() {
  let lastCall;
  return {
    model: {
      specificationVersion: "v3",
      provider: "test-provider",
      modelId: "fake-model",
      get supportedUrls() {
        return {};
      },
      /**
       * @param {any} options
       */
      async doGenerate(options) {
        lastCall = options;
        if (options.responseFormat?.type === "json") {
          return {
            content: [{ type: "text", text: JSON.stringify({ value: 7 }) }],
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: "hello from sdk agent" }],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      },
      async doStream() {
        throw new Error("stream not implemented in test");
      },
    },
    getLastCall() {
      return lastCall;
    },
  };
}
describe("SDK agents", () => {
  test("AnthropicAgent accepts a prebuilt model and preserves instructions", async () => {
    const fake = createFakeModel();
    const agent = new AnthropicAgent({
      id: "anthropic-sdk",
      model: fake.model,
      instructions: "You are a reviewer.",
    });
    const result = await agent.generate({ prompt: "review this file" });
    expect(result.text).toBe("hello from sdk agent");
    expect(fake.getLastCall()?.prompt?.[0]?.role).toBe("system");
    expect(fake.getLastCall()?.prompt?.[0]?.content).toBe("You are a reviewer.");
  });
  test("OpenAIAgent accepts a prebuilt model and preserves instructions", async () => {
    const fake = createFakeModel();
    const agent = new OpenAIAgent({
      id: "openai-sdk",
      model: fake.model,
      instructions: "You are an implementer.",
    });
    const result = await agent.generate({ prompt: "write the patch" });
    expect(result.text).toBe("hello from sdk agent");
    expect(fake.getLastCall()?.prompt?.[0]?.role).toBe("system");
    expect(fake.getLastCall()?.prompt?.[0]?.content).toBe("You are an implementer.");
  });
  test("OpenAIAgent applies baseURL/apiKey convenience options for string models", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let authorization = "";
    try {
      globalThis.fetch = async (url, init) => {
        requestUrl = String(url);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        throw new Error("captured OpenAI request");
      };
      const agent = new OpenAIAgent({
        id: "openai-sdk-local",
        model: "local-model",
        baseURL: "http://127.0.0.1:8080/v1",
        apiKey: "none",
      });
      let message = "";
      try {
        await agent.generate({ prompt: "hit local server" });
      } catch (error) {
        message = error?.cause?.message ?? error?.message ?? String(error);
      }
      expect(message).toContain("captured OpenAI request");
      expect(requestUrl).toContain("http://127.0.0.1:8080/v1");
      expect(authorization).toBe("Bearer none");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("OpenAIAgent rejects provider options with a prebuilt model", () => {
    const fake = createFakeModel();
    expect(
      () =>
        new OpenAIAgent({
          id: "openai-sdk-conflict",
          model: fake.model,
          baseURL: "http://127.0.0.1:8080/v1",
        }),
    ).toThrow(/baseURL\/apiKey\/api can only be used when model is a string/);
  });
  test("OpenAIAgent rejects the api option with a prebuilt model", () => {
    const fake = createFakeModel();
    expect(
      () =>
        new OpenAIAgent({
          id: "openai-sdk-api-conflict",
          model: fake.model,
          api: "chat",
        }),
    ).toThrow(/baseURL\/apiKey\/api can only be used when model is a string/);
  });
  test.each([
    ["chat", "/chat/completions"],
    ["responses", "/responses"],
    [undefined, "/responses"],
  ])("OpenAIAgent api=%p routes string models to the %s endpoint", async (api, expectedPath) => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    try {
      globalThis.fetch = async (url) => {
        requestUrl = String(url);
        throw new Error("captured OpenAI request");
      };
      const agent = new OpenAIAgent({
        id: "openai-sdk-api-surface",
        model: "compat-model",
        baseURL: "http://127.0.0.1:8080/v1",
        apiKey: "none",
        ...(api === undefined ? {} : { api }),
      });
      try {
        await agent.generate({ prompt: "hit compat server" });
      } catch {
        // request capture aborts the call; the URL is the assertion target
      }
      expect(requestUrl).toBe(`http://127.0.0.1:8080/v1${expectedPath}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("OpenAIAgent sanitizes Zod outputSchema for OpenAI strict mode (defaults/optionals land in required)", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody = "";
    try {
      globalThis.fetch = async (_url, init) => {
        requestBody = typeof init?.body === "string" ? init.body : "";
        throw new Error("captured OpenAI request");
      };
      const agent = new OpenAIAgent({
        id: "openai-sdk-strict-schema",
        model: "compat-model",
        baseURL: "http://127.0.0.1:8080/v1",
        apiKey: "none",
        api: "chat",
      });
      const outputSchema = z.object({
        verdict: z.string(),
        categories: z.array(z.string()).default([]),
        note: z.string().optional(),
      });
      try {
        await agent.generate({ prompt: "assess", outputSchema });
      } catch {
        // request capture aborts the call; the body is the assertion target
      }
      const body = JSON.parse(requestBody);
      const schema = body?.response_format?.json_schema?.schema;
      expect(schema?.type).toBe("object");
      expect(schema?.additionalProperties).toBe(false);
      expect((schema?.required ?? []).toSorted()).toEqual(["categories", "note", "verdict"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("OpenAIAgent forwards outputSchema through the SDK structured output channel", async () => {
    const fake = createFakeModel();
    const agent = new OpenAIAgent({
      id: "openai-sdk-structured",
      model: fake.model,
    });
    const result = await agent.generate({
      prompt: "return a value",
      outputSchema: z.object({ value: z.number() }),
    });
    expect(result.text).toBe(JSON.stringify({ value: 7 }));
    expect(fake.getLastCall()?.responseFormat).toMatchObject({
      type: "json",
    });
  });
  test("OpenAIAgent preserves Zod defaults and transforms after native JSON-schema generation", async () => {
    const fake = createFakeModel();
    fake.model.doGenerate = async (options) => {
      fake.lastCall = options;
      if (options.responseFormat?.type === "json") {
        return {
          content: [{ type: "text", text: JSON.stringify({ value: "7" }) }],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      }
      return {
        content: [{ type: "text", text: "hello" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    };
    const schema = z.object({
      value: z.coerce.number().transform((value) => value * 2),
      label: z.string().default("default-label"),
    });
    const result = await new OpenAIAgent({ model: fake.model }).generate({
      prompt: "return a value",
      outputSchema: schema,
    });
    expect(result.output).toEqual({ value: 14, label: "default-label" });
  });
  test("OpenAIAgent preserves Zod defaults and transforms when onStepEnd is also passed (the engine's heartbeat callback rides along on every real Task call)", async () => {
    const fake = createFakeModel();
    fake.model.doGenerate = async (options) => {
      fake.lastCall = options;
      if (options.responseFormat?.type === "json") {
        return {
          content: [{ type: "text", text: JSON.stringify({ value: "7" }) }],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      }
      return {
        content: [{ type: "text", text: "hello" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    };
    const schema = z.object({
      value: z.coerce.number().transform((value) => value * 2),
      label: z.string().default("default-label"),
    });
    const steps = [];
    const result = await new OpenAIAgent({ model: fake.model }).generate({
      prompt: "return a value",
      outputSchema: schema,
      onStepEnd: (step) => {
        steps.push(step);
      },
    });
    expect(result.output).toEqual({ value: 14, label: "default-label" });
    expect(steps).toHaveLength(1);
  });
  test("OpenAIAgent defers invalid Zod output errors until direct output access", async () => {
    const fake = createFakeModel();
    fake.model.doGenerate = async () => ({
      content: [{ type: "text", text: JSON.stringify({ value: "not-a-number" }) }],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    });
    const result = await new OpenAIAgent({ model: fake.model }).generate({
      prompt: "return a number",
      outputSchema: z.object({ value: z.number() }),
    });
    expect(() => result.output).toThrow();
    expect(result.text).toContain("not-a-number");
  });
  test("OpenAIAgent can disable native structured output for local providers", async () => {
    const fake = createFakeModel();
    const agent = new OpenAIAgent({
      id: "openai-sdk-prompt-structured",
      model: fake.model,
      nativeStructuredOutput: false,
    });
    const result = await agent.generate({
      prompt: "return a value",
      outputSchema: z.object({ value: z.number() }),
    });
    expect(result.text).toBe("hello from sdk agent");
    expect(fake.getLastCall()?.responseFormat).toBeUndefined();
  });
  test("AnthropicAgent forwards outputSchema through the SDK structured output channel", async () => {
    const fake = createFakeModel();
    const agent = new AnthropicAgent({
      id: "anthropic-sdk-structured",
      model: fake.model,
    });
    const result = await agent.generate({
      prompt: "return a value",
      outputSchema: z.object({ value: z.number() }),
    });
    expect(result.text).toBe(JSON.stringify({ value: 7 }));
    expect(fake.getLastCall()?.responseFormat).toMatchObject({
      type: "json",
    });
  });
  test.each([
    ["OpenAIAgent", OpenAIAgent],
    ["AnthropicAgent", AnthropicAgent],
  ])("%s forwards runtime tools to the SDK model", async (_name, Agent) => {
    const fake = createFakeModel();
    const agent = new Agent({
      id: "sdk-runtime-tools",
      model: fake.model,
    });
    await agent.generate({
      prompt: "Use memory if it helps.",
      tools: {
        remember: {
          description: "Remember a durable fact.",
          inputSchema: z.object({ content: z.string() }),
          execute: async ({ content }) => ({ saved: content.length > 0 }),
        },
      },
    });
    expect(fake.getLastCall()?.tools?.[0]).toMatchObject({
      name: "remember",
      description: "Remember a durable fact.",
    });
  });
  test("OpenAIAgent streams assistant deltas through onStdout", async () => {
    const model = new MockLanguageModelV3({
      modelId: "mock-stream-model",
      doGenerate: async () => ({
        content: [{ type: "text", text: "generate-path" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "hello" },
            { type: "text-delta", id: "text-1", delta: " world" },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 2, text: 2, reasoning: undefined },
              },
            },
          ],
        }),
      }),
    });
    const agent = new OpenAIAgent({
      id: "openai-sdk-stream",
      model: model,
    });
    let streamed = "";
    const result = await agent.generate({
      prompt: "stream this",
      onStdout: (text) => {
        streamed += text;
      },
    });
    expect(result.text).toBe("hello world");
    expect(streamed).toBe("hello world");
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doGenerateCalls).toHaveLength(0);
  });
  test("OpenAIAgent forwards message history and step callbacks", async () => {
    const fake = createFakeModel();
    const agent = new OpenAIAgent({
      id: "openai-sdk-messages",
      model: fake.model,
    });
    const steps = [];
    const result = await agent.generate({
      messages: [{ role: "user", content: "continue from history" }],
      onStepEnd: (step) => {
        steps.push(step);
      },
    });
    expect(result.text).toBe("hello from sdk agent");
    expect(fake.getLastCall()?.prompt?.[0]?.role).toBe("user");
    expect(fake.getLastCall()?.prompt?.[0]?.content).toEqual([{ type: "text", text: "continue from history" }]);
    expect(steps).toHaveLength(1);
    expect(Array.isArray(steps[0]?.response?.messages)).toBe(true);
  });
  test("AnthropicAgent forwards message history and step callbacks", async () => {
    const fake = createFakeModel();
    const agent = new AnthropicAgent({
      id: "anthropic-sdk-messages",
      model: fake.model,
    });
    const steps = [];
    const result = await agent.generate({
      messages: [{ role: "user", content: "resume this thread" }],
      onStepEnd: (step) => {
        steps.push(step);
      },
    });
    expect(result.text).toBe("hello from sdk agent");
    expect(fake.getLastCall()?.prompt?.[0]?.role).toBe("user");
    expect(fake.getLastCall()?.prompt?.[0]?.content).toEqual([{ type: "text", text: "resume this thread" }]);
    expect(steps).toHaveLength(1);
    expect(Array.isArray(steps[0]?.response?.messages)).toBe(true);
  });
  test("SDK agents accept structured timeout configuration", async () => {
    const fake = createFakeModel();
    const agent = new OpenAIAgent({
      id: "openai-sdk-timeout",
      model: fake.model,
    });
    const result = await agent.generate({
      prompt: "respect timeout typing",
      timeout: { totalMs: 250, stepMs: 100 },
    });
    expect(result.text).toBe("hello from sdk agent");
  });
});
