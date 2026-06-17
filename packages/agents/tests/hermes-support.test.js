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
    process.env.HERMES_BASE_URL = "http://127.0.0.1:5123/v1";
    process.env.HERMES_API_KEY = "env-hermes-key";

    let requestUrl = "";
    let authorization = "";
    let body;
    globalThis.fetch = async (url, init) => {
      requestUrl = String(url);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      body = JSON.parse(String(init?.body));

      return new Response(JSON.stringify({
        id: "resp-hermes-test",
        created_at: 1,
        model: body.model,
        output: [{
          type: "message",
          id: "msg-hermes-test",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "parsed hermes text",
            annotations: [],
          }],
        }],
        usage: {
          input_tokens: 3,
          output_tokens: 2,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const agent = new HermesAgent();
    const result = await agent.generate({
      prompt: "say hi",
      outputSchema: z.object({ value: z.string() }),
    });

    expect(result.text).toBe("parsed hermes text");
    expect(requestUrl).toContain("http://127.0.0.1:5123/v1");
    expect(authorization).toBe("Bearer env-hermes-key");
    expect(body.model).toBe("hermes");
    expect(body.response_format).toBeUndefined();
  });
});
