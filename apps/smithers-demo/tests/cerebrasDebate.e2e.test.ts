import { describe, expect, test } from "vitest";
import { callCerebrasChat, callProviderChat, DEBATE_E2E_PROMPT, runDebateWorkflow } from "../src/cerebrasDebate.js";

describe("Cerebras debate e2e workflow", () => {
  test("runs the required communism versus capitalism loop through a judge", async () => {
    const calls: string[] = [];
    const result = await runDebateWorkflow({
      apiKey: "test-key",
      prompt: DEBATE_E2E_PROMPT,
      rounds: 2,
      chat: async ({ messages }) => {
        const role = String(messages[0].content).includes("neutral judge")
          ? "judge"
          : String(messages[0].content).includes("capitalism")
            ? "capitalism"
            : "communism";
        calls.push(role);
        return `${role} generated response`;
      },
    });

    expect(result.prompt).toBe(DEBATE_E2E_PROMPT);
    expect(calls).toEqual(["capitalism", "communism", "capitalism", "communism", "judge"]);
    expect(result.transcript).toHaveLength(5);
    expect(result.finalResult).toBe("judge generated response");
  });

  test("supports OpenAI and Claude provider request shapes", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];

    await callProviderChat({
      provider: "openai",
      apiKey: "openai-key",
      model: "gpt-5.5",
      messages: [{ role: "user", content: DEBATE_E2E_PROMPT }],
      fetchImpl: (async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ choices: [{ message: { content: "openai result" } }] }), {
          status: 200,
        });
      }) as typeof fetch,
    });

    await callProviderChat({
      provider: "anthropic",
      apiKey: "anthropic-key",
      model: "claude-opus-4.7",
      messages: [
        { role: "system", content: "judge fairly" },
        { role: "user", content: DEBATE_E2E_PROMPT },
      ],
      fetchImpl: (async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ content: [{ type: "text", text: "claude result" }] }), {
          status: 200,
        });
      }) as typeof fetch,
    });

    expect(requests[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(requests[0].init.headers).toMatchObject({ Authorization: "Bearer openai-key" });
    expect(JSON.parse(String(requests[0].init.body))).toMatchObject({ model: "gpt-5.5" });
    expect(requests[1].url).toBe("https://api.anthropic.com/v1/messages");
    expect(requests[1].init.headers).toMatchObject({ "x-api-key": "anthropic-key" });
    expect(JSON.parse(String(requests[1].init.body))).toMatchObject({ model: "claude-opus-4.7" });
  });

  test("posts to the real Cerebras chat completions endpoint shape", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const content = await callCerebrasChat({
      apiKey: "test-key",
      model: "gpt-oss-120b",
      messages: [{ role: "user", content: DEBATE_E2E_PROMPT }],
      fetchImpl: (async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "generated final result" } }],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    expect(content).toBe("generated final result");
    expect(requests[0].url).toBe("https://api.cerebras.ai/v1/chat/completions");
    expect(requests[0].init.method).toBe("POST");
    expect(requests[0].init.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(requests[0].init.body))).toMatchObject({
      model: "gpt-oss-120b",
      messages: [{ role: "user", content: DEBATE_E2E_PROMPT }],
    });
  });

  test("cancels a running provider workflow through AbortSignal", async () => {
    const controller = new AbortController();
    const calls: string[] = [];

    await expect(
      runDebateWorkflow({
        apiKey: "test-key",
        prompt: DEBATE_E2E_PROMPT,
        signal: controller.signal,
        chat: async ({ messages, signal }) => {
          calls.push(String(messages[0].content));
          controller.abort(new Error("Workflow cancelled"));
          signal?.throwIfAborted();
          return "should not complete";
        },
      }),
    ).rejects.toThrow("Workflow cancelled");

    expect(calls).toHaveLength(1);
  });

  const liveTest = process.env.CEREBRAS_API_KEY ? test : test.skip;

  liveTest("generates a real Cerebras debate result when CEREBRAS_API_KEY is set", async () => {
    const result = await runDebateWorkflow({
      apiKey: process.env.CEREBRAS_API_KEY ?? "",
      prompt: DEBATE_E2E_PROMPT,
      rounds: 1,
    });

    expect(result.finalResult.length).toBeGreaterThan(20);
    expect(result.transcript.at(-1)?.role).toBe("judge-final");
  });
});
