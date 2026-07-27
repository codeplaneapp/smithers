import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

for (const path of [
  "../prompts/docs-patcher/patch-docs.mdx",
  "../prompts/docs-patcher/verify.mdx",
  "../prompts/docs-patcher/create-pr.mdx",
]) mock.module(path, () => ({ default: () => "prompt" }));

test("covers docs-patcher", async () => {
  const result = await coverExample("../docs-patcher.jsx", {
    expectedNodes: ["detect-drift", "patch-docs", "verify", "create-pr"],
  });

  expect(result.executed).toHaveLength(4);
  expect(result.executed).toEqual(
    expect.arrayContaining(["detect-drift", "patch-docs", "verify", "create-pr"]),
  );
  expect(result.taskOutputs["patch-docs"][0]).toMatchObject({
    patches: expect.any(Array),
    filesChanged: expect.any(Array),
  });
});
