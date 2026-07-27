import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const Prompt = () => "test prompt";
for (const name of ["intake", "moderate", "action"]) {
  mock.module(`../prompts/trust-safety-moderator/${name}.mdx`, () => ({ default: Prompt }));
}

test("covers trust-safety-moderator", async () => {
  const result = await coverExample("../trust-safety-moderator.jsx", {
    input: { content: "hello", authorId: "u1" },
    mocks: {
      intake: {
        contentId: "c1", contentType: "text", rawText: "hello",
        metadata: { source: "user_submission", authorId: "u1" },
      },
      moderate: {
        contentId: "c1", riskLevel: "allow", policyClass: "safe", confidence: 1,
        reasoning: "safe", flaggedSegments: [], needsHumanReview: false,
      },
      action: {
        contentId: "c1", decision: "approved", action: "publish",
        moderatedContent: "hello", summary: "approved",
      },
    },
  });

  expect(result.executed).toEqual(["intake", "moderate", "action"]);
  expect(result.taskOutputs.action[0]).toMatchObject({
    contentId: "c1", decision: "approved", action: "publish",
  });
});
