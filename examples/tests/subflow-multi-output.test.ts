import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers subflow-multi-output", async () => {
  const result = await coverExample("../subflow-multi-output.jsx", {
    input: { topic: "release notes" },
    executeCompute: true,
    mocks: { review: { decision: "publish", wordCount: 4 } },
  });

  expect(result.executed).toEqual(["review", "announce"]);
  expect(result.taskOutputs.review[0]).toEqual({ decision: "publish", wordCount: 4 });
  expect(result.taskOutputs.announce[0]).toEqual({
    headline: 'Child decided "publish" at 4 words',
  });
});
