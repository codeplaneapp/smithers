import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { HermesAgent } from "../src/HermesAgent.js";
import { HermesAgent as ExportedHermesAgent } from "../src/index.js";

const originalEnv = {
  HERMES_API_KEY: process.env.HERMES_API_KEY,
  HERMES_BASE_URL: process.env.HERMES_BASE_URL,
};
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalEnv.HERMES_API_KEY === undefined) {
    delete process.env.HERMES_API_KEY;
  } else {
    process.env.HERMES_API_KEY = originalEnv.HERMES_API_KEY;
  }
  if (originalEnv.HERMES_BASE_URL === undefined) {
    delete process.env.HERMES_BASE_URL;
  } else {
    process.env.HERMES_BASE_URL = originalEnv.HERMES_BASE_URL;
  }
  globalThis.fetch = originalFetch;
});

describe("HermesAgent", () => {
  test("is available from the public agents barrel", () => {
    expect(ExportedHermesAgent).toBe(HermesAgent);
  });

  test("requires a Hermes OpenAI-compatible baseURL", () => {
    delete process.env.HERMES_BASE_URL;

    expect(() => new HermesAgent()).toThrow(/requires a baseURL/);
    expect(() => new HermesAgent({ baseURL: "   " })).toThrow(/requires a baseURL/);
  });

  test("uses Hermes provider defaults and parses OpenAI-compatible output", async () => {
    process.env.HERMES_BASE_URL = "http://127.0.0.1:5123";
    process.env.HERMES_API_KEY = "env-hermes-key";

    let requestUrl = "";
    let authorization = "";
    let body;
    globalThis.fetch = async (url, init) => {
      requestUrl = String(url);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      body = JSON.parse(typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body));

      return new Response(
        [
          'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg-hermes-test","role":"assistant","content":[]}}',
          'data: {"type":"response.output_text.delta","item_id":"msg-hermes-test","output_index":0,"content_index":0,"delta":"parsed hermes text"}',
          'data: {"type":"response.output_text.done","item_id":"msg-hermes-test","output_index":0,"content_index":0,"text":"parsed hermes text"}',
          'data: {"type":"response.completed","response":{"id":"resp-hermes-test","usage":{"input_tokens":3,"output_tokens":2}}}',
          "",
        ].join("\n\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    };

    const agent = new HermesAgent();
    const result = await agent.generate({
      prompt: "say hi",
      outputSchema: z.object({ value: z.string() }),
    });

    expect(result.text).toBe("parsed hermes text");
    expect(requestUrl).toBe("http://127.0.0.1:5123/v1/responses");
    expect(authorization).toBe("Bearer env-hermes-key");
    expect(body.model).toBe("hermes");
    expect(body.response_format).toBeUndefined();
  });
});
