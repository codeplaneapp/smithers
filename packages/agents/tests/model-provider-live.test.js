import { describe, expect, it } from "bun:test";
import { Effect, Fiber, Stream } from "effect";
import { z } from "zod";
import { AnthropicAgent } from "../src/AnthropicAgent.js";
import { OpenAIAgent } from "../src/OpenAIAgent.js";
import { runRealAgentE2E } from "./real-agent-e2e.js";

const answerSchema = z.object({ answer: z.literal(4) });
const prompt = "What is 2+2? Return the answer in the requested JSON shape.";

const smoke = async (agent) => {
  const result = await agent.generate({
    prompt: `${prompt} First call the add tool with 2 and 2, then use its result.`,
    outputSchema: answerSchema,
    tools: {
      add: {
        inputSchema: z.object({ left: z.number(), right: z.number() }),
        execute: ({ left, right }) => left + right,
      },
    },
  });
  expect(result.output).toEqual({ answer: 4 });
  expect(result.text.length).toBeGreaterThan(0);
  expect(result.response.messages.length).toBeGreaterThan(0);
  expect(result.toolCalls.some((call) => call.toolName === "add")).toBe(true);
  expect(result.toolResults.some((toolResult) => toolResult.output === 4)).toBe(true);

  const streamed = await Effect.runPromise(
    Stream.runCollect(agent.run({ prompt: { text: "Reply with exactly: streamed" } }, {})),
  ).then(Array.from);
  expect(streamed.some((event) => event._tag === "model-delta")).toBe(true);
  expect(streamed.at(-1)?._tag).toBe("resolved");

  let sawModelEvent;
  const firstModelEvent = new Promise((resolve) => {
    sawModelEvent = resolve;
  });
  const cancellationStream = agent
    .run({ prompt: { text: "Write a very long essay." } }, {})
    .pipe(Stream.tap((event) => Effect.sync(() => {
      if (event._tag.startsWith("model-")) sawModelEvent();
    })));
  const fiber = Effect.runFork(Stream.runDrain(cancellationStream));
  await firstModelEvent;
  await Effect.runPromise(Fiber.interrupt(fiber));
  expect((await Effect.runPromise(Fiber.await(fiber)))._tag).toBe("Failure");
};

describe.skipIf(!runRealAgentE2E)("flows Model provider live smoke", () => {
  it.skipIf(!process.env.ANTHROPIC_API_KEY)("streams Anthropic Messages", async () => {
    await smoke(
      new AnthropicAgent({
        model: process.env.SMITHERS_ANTHROPIC_SMOKE_MODEL ?? "claude-sonnet-4-5",
        maxOutputTokens: 128,
      }),
    );
  }, 120_000);

  it.skipIf(!process.env.OPENAI_API_KEY)("streams OpenAI Responses", async () => {
    await smoke(
      new OpenAIAgent({
        model: process.env.SMITHERS_OPENAI_SMOKE_MODEL ?? "gpt-5-mini",
        maxOutputTokens: 128,
      }),
    );
  }, 120_000);

  it.skipIf(!process.env.SMITHERS_OPENAI_COMPATIBLE_BASE_URL || !process.env.SMITHERS_OPENAI_COMPATIBLE_API_KEY)(
    "streams an OpenAI-compatible provider",
    async () => {
      await smoke(
        new OpenAIAgent({
          model: process.env.SMITHERS_OPENAI_COMPATIBLE_MODEL ?? "default",
          baseURL: process.env.SMITHERS_OPENAI_COMPATIBLE_BASE_URL,
          apiKey: process.env.SMITHERS_OPENAI_COMPATIBLE_API_KEY,
          maxOutputTokens: 128,
        }),
      );
    },
    120_000,
  );
});
