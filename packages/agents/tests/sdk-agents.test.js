import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as ModelEvent from "@flows/model/ModelEvent";
import { Effect, Stream } from "effect";
import { z } from "zod";
import { AnthropicAgent, OpenAIAgent } from "../src/index.js";

const originalFetch = globalThis.fetch;
let fetchImplementation = originalFetch;
const proxyFetch = (...args) => fetchImplementation(...args);

beforeEach(() => {
  fetchImplementation = originalFetch;
  globalThis.fetch = proxyFetch;
});

afterEach(() => {
  fetchImplementation = originalFetch;
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const textEvents = (text, usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }) => [
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "text" }),
  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "text", text }),
  ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "text" }),
  ModelEvent.ModelEvent.Usage(usage),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" }),
];

function createFakeModel(responses = ["hello from flows model"]) {
  const requests = [];
  let index = 0;
  return {
    model: {
      stream(request) {
        requests.push(request);
        const response = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return Stream.fromIterable(Array.isArray(response) ? response : textEvents(response));
      },
    },
    requests,
    getLastCall() {
      return requests.at(-1);
    },
  };
}

const openAISse = (text = "openai response") =>
  [
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg-test","role":"assistant","content":[]}}',
    `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg-test", output_index: 0, content_index: 0, delta: text })}`,
    `data: ${JSON.stringify({ type: "response.output_text.done", item_id: "msg-test", output_index: 0, content_index: 0, text })}`,
    'data: {"type":"response.completed","response":{"id":"resp-test","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
    "",
  ].join("\n\n");

const anthropicSse = (text = "anthropic response") =>
  [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-test","type":"message","role":"assistant","content":[],"model":"claude-test","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
    "",
  ].join("\n\n");

const response = (body) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

/** One turn that calls a tool, then a turn that settles with text. */
const toolCallThenText = (id, name, args, text) => {
  let call = 0;
  return {
    stream() {
      call += 1;
      if (call === 1) {
        return Stream.fromIterable([
          ModelEvent.ModelEvent.ToolCallStart({ type: "tool-call-start", id, name }),
          ModelEvent.ModelEvent.ToolCallDelta({ type: "tool-call-delta", id, arguments: args }),
          ModelEvent.ModelEvent.ToolCallEnd({ type: "tool-call-end", id, arguments: args }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "tool-calls" }),
        ]);
      }
      return Stream.fromIterable(textEvents(text));
    },
  };
};

const decodeBody = (body) => (typeof body === "string" ? body : new TextDecoder().decode(body));

describe("flows model agents", () => {
  test("Anthropic and OpenAI expose the flows Harness entrypoint", async () => {
    for (const Agent of [AnthropicAgent, OpenAIAgent]) {
      const fake = createFakeModel();
      const agent = new Agent({ model: fake.model, modelId: "test-model" });
      const events = await Effect.runPromise(
        Stream.runCollect(agent.run({ prompt: { text: "use the harness" } }, {})),
      ).then(Array.from);
      expect(events.some((event) => event._tag === "model-delta")).toBe(true);
      expect(events.at(-1)?._tag).toBe("resolved");
    }
  });

  test("Harness execution runs configured tools with the host context", async () => {
    const host = { host: "test-layer" };
    let received;
    const agent = new OpenAIAgent({
      model: toolCallThenText("call-1", "lookup", '{"key":"answer"}', "done"),
      modelId: "gpt-test",
      tools: {
        lookup: {
          inputSchema: z.object({ key: z.string() }),
          execute(input, context) {
            received = { input, context };
            return "42";
          },
        },
      },
    });
    const events = await Effect.runPromise(Stream.runCollect(agent.run({ prompt: { text: "use lookup" } }, host)));
    expect(received.input).toEqual({ key: "answer" });
    expect(received.context.harnessHost).toBe(host);
    expect(Array.from(events).at(-1)?._tag).toBe("resolved");
  });

  test("Harness interruption cancels the active model stream", async () => {
    let cancelled = false;
    const model = {
      stream() {
        return Stream.concat(
          Stream.make(ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "text", text: "started" })),
          Stream.never,
        ).pipe(Stream.ensuring(Effect.sync(() => { cancelled = true; })));
      },
    };
    const agent = new AnthropicAgent({ model, modelId: "claude-test" });
    await Effect.runPromise(Stream.runDrain(Stream.take(agent.run({ prompt: { text: "wait" } }, {}), 1)));
    expect(cancelled).toBe(true);
  });

  test("AnthropicAgent accepts a prebuilt model and preserves instructions", async () => {
    const fake = createFakeModel();
    const agent = new AnthropicAgent({
      id: "anthropic-flows",
      model: fake.model,
      modelId: "claude-test",
      instructions: "You are a reviewer.",
    });
    const result = await agent.generate({ prompt: "review this file" });
    expect(result.text).toBe("hello from flows model");
    expect(fake.getLastCall().system[0]).toEqual({ type: "text", text: "You are a reviewer." });
    expect(fake.getLastCall().modelId).toBe("claude-test");
  });

  test("OpenAIAgent accepts a prebuilt model and preserves instructions", async () => {
    const fake = createFakeModel();
    const agent = new OpenAIAgent({
      id: "openai-flows",
      model: fake.model,
      modelId: "gpt-test",
      instructions: "You are an implementer.",
    });
    const result = await agent.generate({ prompt: "write the patch" });
    expect(result.text).toBe("hello from flows model");
    expect(fake.getLastCall().system[0]).toEqual({ type: "text", text: "You are an implementer." });
    expect(result.response.modelId).toBe("gpt-test");
  });

  test("prebuilt Models require an explicit modelId", () => {
    const fake = createFakeModel();
    expect(() => new OpenAIAgent({ model: fake.model })).toThrow(/requires modelId/);
    expect(() => new AnthropicAgent({ model: fake.model })).toThrow(/requires modelId/);
  });

  test("OpenAIAgent applies baseURL/apiKey convenience options for string models", async () => {
    let requestUrl = "";
    let authorization = "";
    let body;
    fetchImplementation = async (url, init) => {
      requestUrl = String(url);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      body = JSON.parse(decodeBody(init?.body));
      return response(openAISse("local response"));
    };
    const agent = new OpenAIAgent({
      id: "openai-flows-local",
      model: "local-model",
      baseURL: "http://127.0.0.1:8080/v1",
      apiKey: "none",
    });
    const result = await agent.generate({ prompt: "hit local server" });
    expect(result.text).toBe("local response");
    expect(requestUrl).toBe("http://127.0.0.1:8080/v1/responses");
    expect(authorization).toBe("Bearer none");
    expect(body.model).toBe("local-model");
  });

  test("OpenAIAgent rejects provider options with a prebuilt model", () => {
    const fake = createFakeModel();
    expect(
      () =>
        new OpenAIAgent({
          id: "openai-flows-conflict",
          model: fake.model,
          modelId: "gpt-test",
          baseURL: "http://127.0.0.1:8080/v1",
        }),
    ).toThrow(/baseURL\/apiKey\/api can only be used when model is a string/);
  });

  test("OpenAIAgent rejects the api option with a prebuilt model", () => {
    const fake = createFakeModel();
    expect(
      () =>
        new OpenAIAgent({
          id: "openai-flows-api-conflict",
          model: fake.model,
          modelId: "gpt-test",
          api: "responses",
        }),
    ).toThrow(/baseURL\/apiKey\/api can only be used when model is a string/);
  });

  test.each([
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080/v1/responses"],
    ["http://127.0.0.1:8080/v1", "http://127.0.0.1:8080/v1/responses"],
    ["http://127.0.0.1:8080/v1/", "http://127.0.0.1:8080/v1/responses"],
  ])("OpenAIAgent normalizes baseURL %s to %s", async (baseURL, expectedUrl) => {
    let requestUrl = "";
    fetchImplementation = async (url) => {
      requestUrl = String(url);
      return response(openAISse());
    };
    await new OpenAIAgent({ model: "compat-model", baseURL, apiKey: "none" }).generate({ prompt: "route" });
    expect(requestUrl).toBe(expectedUrl);
  });

  test("OpenAIAgent rejects legacy chat completions routing", () => {
    expect(() => new OpenAIAgent({ model: "gpt", api: "chat" })).toThrow(/Responses protocol/);
  });

  test("OpenAIAgent sends standard JSON Schema prompt fallback", async () => {
    const fake = createFakeModel(['{"verdict":"pass","categories":[],"note":"ok"}']);
    const outputSchema = z.object({
      verdict: z.string(),
      categories: z.array(z.string()).default([]),
      note: z.string().optional(),
    });
    const agent = new OpenAIAgent({ model: fake.model, modelId: "gpt-test" });
    const result = await agent.generate({ prompt: "assess", outputSchema });
    const instruction = fake.getLastCall().system.at(-1).text;
    const schema = JSON.parse(instruction.split("\n").at(-1));
    expect(agent.supportsNativeStructuredOutput).toBe(false);
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBeUndefined();
    expect(schema.required).toEqual(["verdict"]);
    expect(Object.keys(schema.properties).toSorted()).toEqual(["categories", "note", "verdict"]);
    expect(result.output).toEqual({ verdict: "pass", categories: [], note: "ok" });
  });

  test("OpenAIAgent preserves Zod defaults and transforms after fallback parsing", async () => {
    const fake = createFakeModel(['{"value":"7"}']);
    const schema = z.object({
      value: z.coerce.number().transform((value) => value * 2),
      label: z.string().default("default-label"),
    });
    const result = await new OpenAIAgent({ model: fake.model, modelId: "gpt-test" }).generate({
      prompt: "return a value",
      outputSchema: schema,
    });
    expect(result.output).toEqual({ value: 14, label: "default-label" });
  });

  test("OpenAIAgent preserves transforms when onStepEnd is also passed", async () => {
    const fake = createFakeModel(['{"value":"7"}']);
    const steps = [];
    const result = await new OpenAIAgent({ model: fake.model, modelId: "gpt-test" }).generate({
      prompt: "return a value",
      outputSchema: z.object({ value: z.coerce.number().transform((value) => value * 2) }),
      onStepEnd: (step) => steps.push(step),
    });
    expect(result.output).toEqual({ value: 14 });
    expect(steps).toHaveLength(1);
  });

  test("OpenAIAgent does not throw a raw SyntaxError for non-JSON fallback text", async () => {
    const fake = createFakeModel(["not json"]);
    const agent = new OpenAIAgent({ model: fake.model, modelId: "gpt-test", nativeStructuredOutput: true });
    const result = await agent.generate({
      prompt: "return a number",
      outputSchema: z.object({ value: z.number() }),
    });
    expect(agent.supportsNativeStructuredOutput).toBe(false);
    expect(result.output).toBeUndefined();
    expect(result.text).toBe("not json");
  });

  test("AnthropicAgent uses the same safe structured-output fallback", async () => {
    const fake = createFakeModel(['{"value":7}']);
    const agent = new AnthropicAgent({ model: fake.model, modelId: "claude-test" });
    const result = await agent.generate({
      prompt: "return a value",
      outputSchema: z.object({ value: z.number() }),
    });
    expect(agent.supportsNativeStructuredOutput).toBe(false);
    expect(fake.getLastCall().system.at(-1).text).toContain('"value"');
    expect(result.output).toEqual({ value: 7 });
  });

  test.each([
    ["OpenAIAgent", OpenAIAgent, "gpt-test"],
    ["AnthropicAgent", AnthropicAgent, "claude-test"],
  ])("%s forwards runtime tools to the flows Model", async (_name, Agent, modelId) => {
    const fake = createFakeModel();
    const agent = new Agent({ id: "flows-runtime-tools", model: fake.model, modelId });
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
    expect(fake.getLastCall().tools[0]).toMatchObject({
      name: "remember",
      description: "Remember a durable fact.",
    });
    expect(fake.getLastCall().tools[0].parameters.type).toBe("object");
  });

  test("OpenAIAgent executes streamed tool calls and continues the transcript", async () => {
    const requests = [];
    let call = 0;
    const model = {
      stream(request) {
        requests.push(request);
        call += 1;
        if (call === 1) {
          return Stream.fromIterable([
            ModelEvent.ModelEvent.ToolCallStart({ type: "tool-call-start", id: "call-1", name: "double" }),
            ModelEvent.ModelEvent.ToolCallDelta({ type: "tool-call-delta", id: "call-1", arguments: '{"value":' }),
            ModelEvent.ModelEvent.ToolCallDelta({ type: "tool-call-delta", id: "call-1", arguments: "21}" }),
            ModelEvent.ModelEvent.ToolCallEnd({ type: "tool-call-end", id: "call-1", arguments: '{"value":21}' }),
            ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "tool-calls" }),
          ]);
        }
        return Stream.fromIterable(textEvents("42"));
      },
    };
    const starts = [];
    const ends = [];
    const result = await new OpenAIAgent({ model, modelId: "gpt-test" }).generate({
      prompt: "double 21",
      tools: {
        double: {
          description: "Double a number",
          inputSchema: z.object({ value: z.number() }),
          execute: async ({ value }) => value * 2,
        },
      },
      onToolExecutionStart: (event) => starts.push(event),
      onToolExecutionEnd: (event) => ends.push(event),
    });
    expect(result.text).toBe("42");
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(requests[1].messages.at(-1).content[0].content).toBe("42");
    expect(result.toolCalls[0]).toMatchObject({ toolName: "double", input: { value: 21 } });
    expect(result.toolResults[0]).toMatchObject({ toolName: "double", output: 42, isError: false });
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(result.steps).toHaveLength(2);
  });

  test("validator-style tool schemas hand the tool its arguments, not the validation envelope", async () => {
    let received;
    const model = toolCallThenText("call-1", "echo", '{"value":"hi"}', "done");
    const result = await new OpenAIAgent({ model, modelId: "gpt-test" }).generate({
      prompt: "echo hi",
      tools: {
        echo: {
          description: "Echo a value",
          // The shape zodSchema()/jsonSchema() wrappers produce: a JSON Schema
          // plus a validate() that returns a result object rather than throwing.
          inputSchema: {
            jsonSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
            validate: async (value) => {
              const parsed = z.object({ value: z.string() }).safeParse(value);
              return parsed.success ? { success: true, value: parsed.data } : { success: false, error: parsed.error };
            },
          },
          execute: async (args) => {
            received = args;
            return { echoed: args.value };
          },
        },
      },
    });
    expect(received).toEqual({ value: "hi" });
    expect(result.toolResults[0]).toMatchObject({ output: { echoed: "hi" }, isError: false });
  });

  test("validator-style tool schemas report validation failure as a tool error", async () => {
    let executed = false;
    const model = toolCallThenText("call-1", "echo", '{"value":7}', "recovered");
    const result = await new OpenAIAgent({ model, modelId: "gpt-test" }).generate({
      prompt: "echo 7",
      tools: {
        echo: {
          description: "Echo a value",
          inputSchema: {
            jsonSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
            validate: async (value) => {
              const parsed = z.object({ value: z.string() }).safeParse(value);
              return parsed.success ? { success: true, value: parsed.data } : { success: false, error: parsed.error };
            },
          },
          execute: async () => {
            executed = true;
            return "unreachable";
          },
        },
      },
    });
    expect(executed).toBe(false);
    expect(result.toolResults[0].isError).toBe(true);
    expect(result.text).toBe("recovered");
  });

  test("OpenAIAgent streams assistant deltas through onStdout", async () => {
    let streams = 0;
    const model = {
      stream() {
        streams += 1;
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "text-1" }),
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "text-1", text: "hello" }),
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "text-1", text: " world" }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "text-1" }),
          ModelEvent.ModelEvent.Usage({ inputTokens: 3, outputTokens: 2, totalTokens: 5 }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" }),
        ]);
      },
    };
    const agent = new OpenAIAgent({ id: "openai-flows-stream", model, modelId: "gpt-test" });
    let streamed = "";
    const result = await agent.generate({
      prompt: "stream this",
      onStdout: (text) => {
        streamed += text;
      },
    });
    expect(result.text).toBe("hello world");
    expect(streamed).toBe("hello world");
    expect(streams).toBe(1);
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  });

  test("OpenAIAgent forwards message history and step callbacks", async () => {
    const fake = createFakeModel();
    const agent = new OpenAIAgent({ id: "openai-flows-messages", model: fake.model, modelId: "gpt-test" });
    const steps = [];
    const result = await agent.generate({
      messages: [{ role: "user", content: "continue from history" }],
      onStepFinish: (step) => steps.push(step),
    });
    expect(result.text).toBe("hello from flows model");
    expect(fake.getLastCall().messages[0].role).toBe("user");
    expect(fake.getLastCall().messages[0].content).toEqual([{ type: "text", text: "continue from history" }]);
    expect(steps).toHaveLength(1);
    expect(result.response.messages[0].role).toBe("assistant");
  });

  test("AnthropicAgent forwards rich message history and step callbacks", async () => {
    const fake = createFakeModel();
    const agent = new AnthropicAgent({ id: "anthropic-flows-messages", model: fake.model, modelId: "claude-test" });
    const steps = [];
    const result = await agent.generate({
      messages: [
        { role: "system", content: "Keep context." },
        { role: "user", content: "resume this thread" },
        { role: "assistant", content: [{ type: "text", text: "working" }], finishReason: "stop" },
      ],
      onStepEnd: (step) => steps.push(step),
    });
    expect(result.text).toBe("hello from flows model");
    expect(fake.getLastCall().system[0].text).toBe("Keep context.");
    expect(fake.getLastCall().messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(steps).toHaveLength(1);
    expect(Array.isArray(steps[0].response.messages)).toBe(true);
  });

  test("SDK agents accept structured timeout configuration", async () => {
    const fake = createFakeModel();
    const result = await new OpenAIAgent({
      id: "openai-flows-timeout",
      model: fake.model,
      modelId: "gpt-test",
    }).generate({
      prompt: "respect timeout typing",
      timeout: { totalMs: 250, stepMs: 100 },
    });
    expect(result.text).toBe("hello from flows model");
  });

  test("timeout interrupts the Model.stream fiber", async () => {
    let finalized = false;
    const model = {
      stream: () => Stream.never.pipe(Stream.ensuring(Effect.sync(() => (finalized = true)))),
    };
    const agent = new OpenAIAgent({ model, modelId: "gpt-test" });
    await expect(agent.generate({ prompt: "wait", timeout: { totalMs: 10 } })).rejects.toThrow();
    expect(finalized).toBe(true);
  });

  test("OpenAI provider route streams with official routing and auth", async () => {
    let requestUrl = "";
    let authorization = "";
    let body;
    fetchImplementation = async (url, init) => {
      requestUrl = String(url);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      body = JSON.parse(decodeBody(init?.body));
      return response(openAISse("official openai"));
    };
    const result = await new OpenAIAgent({ model: "gpt-test", apiKey: "openai-secret" }).generate({ prompt: "hi" });
    expect(result.text).toBe("official openai");
    expect(requestUrl).toBe("https://api.openai.com/v1/responses");
    expect(authorization).toBe("Bearer openai-secret");
    expect(body.input[0]).toMatchObject({ role: "user" });
    expect(body.stream).toBe(true);
  });

  test("Anthropic provider route streams with Messages routing and auth", async () => {
    let requestUrl = "";
    let apiKey = "";
    let version = "";
    let body;
    fetchImplementation = async (url, init) => {
      const headers = new Headers(init?.headers);
      requestUrl = String(url);
      apiKey = headers.get("x-api-key") ?? "";
      version = headers.get("anthropic-version") ?? "";
      body = JSON.parse(decodeBody(init?.body));
      return response(anthropicSse("official anthropic"));
    };
    const result = await new AnthropicAgent({ model: "claude-test", apiKey: "anthropic-secret" }).generate({
      prompt: "hi",
    });
    expect(result.text).toBe("official anthropic");
    expect(requestUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(apiKey).toBe("anthropic-secret");
    expect(version).toBe("2023-06-01");
    expect(body.messages[0]).toMatchObject({ role: "user" });
    expect(body.stream).toBe(true);
  });
});
