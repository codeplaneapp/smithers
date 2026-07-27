import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

for (const path of [
  "../prompts/docs-fixup-bot/repair.mdx",
  "../prompts/docs-fixup-bot/verify.mdx",
  "../prompts/docs-fixup-bot/open-pr.mdx",
]) mock.module(path, () => ({ default: () => "prompt" }));

test("covers docs-fixup-bot", async () => {
  const result = await coverExample("../docs-fixup-bot.jsx", {
    expectedNodes: ["scan-docs", "repair", "verify", "open-pr"],
  });

  expect(result.executed).toHaveLength(4);
  expect(result.executed).toEqual(
    expect.arrayContaining(["scan-docs", "repair", "verify", "open-pr"]),
  );
  expect(result.taskOutputs.repair[0]).toMatchObject({
    fixes: expect.any(Array),
    filesChanged: expect.any(Array),
  });
});
