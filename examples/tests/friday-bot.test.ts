import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

for (const path of [
  "../prompts/friday-bot/collect-github.mdx",
  "../prompts/friday-bot/collect-linear.mdx",
  "../prompts/friday-bot/collect-slack.mdx",
  "../prompts/friday-bot/summarize.mdx",
  "../prompts/friday-bot/publish.mdx",
]) mock.module(path, () => ({ default: () => "prompt" }));

test("covers friday-bot", async () => {
  const nodes = [
    "schedule", "collect-github", "collect-linear", "collect-slack", "summarize", "publish",
  ];
  const result = await coverExample("../friday-bot.jsx", { expectedNodes: nodes });

  expect(result.executed).toHaveLength(nodes.length);
  expect(result.executed).toEqual(expect.arrayContaining(nodes));
  expect(result.taskOutputs.summarize[0]).toMatchObject({
    headline: expect.any(String),
    metrics: expect.any(Object),
  });
  expect(result.taskOutputs.publish[0]).toMatchObject({ success: expect.any(Boolean) });
});
